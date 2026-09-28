/**
 * Environment-driven auto-configuration for the Nuwax Codex bridge.
 *
 * Reads custom env vars (CODEX_BASE_URL, CODEX_API_PROTOCOL, CODEX_WIRE_API,
 * CODEX_MODEL, CODEX_LOG_DIR) and translates them into Codex gateway config or
 * system env overrides. All custom logic lives here to keep merge conflicts
 * with upstream codex-acp to a minimum.
 */
import {CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR} from "./CodexAuthMethod";
import {logger} from "./Logger";

// ---------------------------------------------------------------------------
// Public env var names
// ---------------------------------------------------------------------------

export const CODEX_BASE_URL_ENV_VAR = "CODEX_BASE_URL";
export const CODEX_API_PROTOCOL_ENV_VAR = "CODEX_API_PROTOCOL";
export const CODEX_WIRE_API_ENV_VAR = "CODEX_WIRE_API";
export const CODEX_MODEL_ENV_VAR = "CODEX_MODEL";
export const CODEX_LOG_DIR_ENV_VAR = "CODEX_LOG_DIR";
export const CODEX_PROVIDER_ID_ENV_VAR = "CODEX_PROVIDER_ID";
export const CODEX_PROVIDER_NAME_ENV_VAR = "CODEX_PROVIDER_NAME";
export const CODEX_DISABLE_THINKING_ENV_VAR = "CODEX_DISABLE_THINKING";
export const CODEX_PERSONALITY_ENABLED_ENV_VAR = "CODEX_PERSONALITY_ENABLED";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** API protocol family the gateway speaks. */
export type EnvApiProtocol = "openai" | "anthropic";

/**
 * Codex wire-protocol variant within the OpenAI protocol family. The Anthropic
 * family is selected via `CODEX_API_PROTOCOL` and maps to the `"anthropic"`
 * wire on the gateway config.
 */
export type EnvWireApi = "responses" | "chat";

/** Wire value written into the gateway (codex `wire_api`) config field. */
export type GatewayWireApi = EnvWireApi | "anthropic";

/** Well-known provider id used by the auto-configured gateway. */
export const CUSTOM_GATEWAY_ID = "custom-gateway";

/** Shape of the gateway config stored in CodexAcpClient. */
export interface EnvGatewayConfig {
    modelProvider: string;
    config: {
        name: string;
        base_url: string;
        http_headers: Record<string, string>;
        wire_api: GatewayWireApi;
        experimental_bearer_token?: string;
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

    const rawApiProtocol = process.env[CODEX_API_PROTOCOL_ENV_VAR]?.trim();
    const apiProtocol = parseEnvApiProtocol(rawApiProtocol);
    const rawWireApi = process.env[CODEX_WIRE_API_ENV_VAR]?.trim();
    const openAiWire = parseEnvWireApi(rawWireApi);
    if (apiProtocol === "anthropic" && rawWireApi !== undefined && rawWireApi !== "") {
        logger.log(
            `${CODEX_WIRE_API_ENV_VAR}="${rawWireApi}" is ignored because ${CODEX_API_PROTOCOL_ENV_VAR}=anthropic selects the Anthropic protocol family`,
        );
    }
    const wireApi: GatewayWireApi = apiProtocol === "anthropic" ? "anthropic" : openAiWire;

    const providerName =
        process.env[CODEX_PROVIDER_NAME_ENV_VAR]?.trim()
        || process.env[CODEX_MODEL_ENV_VAR]?.trim()
        || "Custom Gateway";

    const headers: Record<string, string> = {"X-Client-Feature-ID": "codex"};

    const apiKey = readAnyApiKey();

    logger.log("Auto-configured gateway from env", {
        baseUrl,
        apiProtocol,
        wireApi,
        providerName,
        hasApiKey: !!apiKey,
    });

    return {
        modelProvider: getEnvProviderId(),
        config: {
            name: providerName,
            base_url: baseUrl,
            http_headers: headers,
            wire_api: wireApi,
            ...(apiKey ? {experimental_bearer_token: apiKey} : {}),
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

/** Returns the custom provider id from env, or the default "custom-gateway". */
export function getEnvProviderId(): string {
    return process.env[CODEX_PROVIDER_ID_ENV_VAR]?.trim() || CUSTOM_GATEWAY_ID;
}

/** Returns true when CODEX_DISABLE_THINKING is set to a truthy value. */
export function isThinkingDisabled(): boolean {
    const raw = process.env[CODEX_DISABLE_THINKING_ENV_VAR]?.trim()?.toLowerCase();
    return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

/**
 * Returns true/false when CODEX_PERSONALITY_ENABLED is explicitly set,
 * undefined when absent (let codex decide).
 */
export function isPersonalityEnabled(): boolean | undefined {
    const raw = process.env[CODEX_PERSONALITY_ENABLED_ENV_VAR]?.trim()?.toLowerCase();
    if (raw === undefined || raw === "") return undefined;
    return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
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

/**
 * Parses `CODEX_API_PROTOCOL`. Unset defaults to the OpenAI protocol family.
 * An unknown value is fatal so a typo cannot silently select the wrong family.
 */
function parseEnvApiProtocol(raw: string | undefined): EnvApiProtocol {
    if (raw === undefined || raw === "") {
        return "openai";
    }
    if (raw === "openai" || raw === "anthropic") {
        return raw;
    }
    throw new Error(
        `Invalid ${CODEX_API_PROTOCOL_ENV_VAR} "${raw}"; expected "openai" or "anthropic".`,
    );
}

/**
 * Parses `CODEX_WIRE_API`, the wire variant within the OpenAI protocol family.
 * Unset defaults to "responses"; an unknown value (including "anthropic") is
 * fatal — select the Anthropic family with ${CODEX_API_PROTOCOL_ENV_VAR}.
 */
function parseEnvWireApi(raw: string | undefined): EnvWireApi {
    if (raw === undefined || raw === "") {
        return "responses";
    }
    if (raw === "responses" || raw === "chat") {
        return raw;
    }
    throw new Error(
        `Invalid ${CODEX_WIRE_API_ENV_VAR} "${raw}"; expected "responses" or "chat" within the OpenAI family, or set ${CODEX_API_PROTOCOL_ENV_VAR}=anthropic for the Anthropic protocol.`,
    );
}
