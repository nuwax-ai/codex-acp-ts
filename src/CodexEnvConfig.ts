/**
 * Environment-driven auto-configuration for the Nuwax Codex bridge.
 *
 * Reads custom env vars (CODEX_BASE_URL, CODEX_API_PROTOCOL, CODEX_WIRE_API, CODEX_BRIDGE,
 * CODEX_MODEL, CODEX_LOG_DIR) and translates them into Codex gateway config or
 * system env overrides. Every variable also accepts a NUWAX_-prefixed alias
 * (NUWAX_BASE_URL, ...) with the resolution rules of {@link resolveEnvAlias};
 * the CODEX_* spellings stay supported forever. All custom logic lives here
 * to keep merge conflicts with upstream codex-acp to a minimum.
 */
import {CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR} from "./CodexAuthMethod";
import {logger} from "./Logger";

// ---------------------------------------------------------------------------
// Public env var names
// ---------------------------------------------------------------------------

export const CODEX_BASE_URL_ENV_VAR = "CODEX_BASE_URL";
export const CODEX_API_PROTOCOL_ENV_VAR = "CODEX_API_PROTOCOL";
export const CODEX_WIRE_API_ENV_VAR = "CODEX_WIRE_API";
export const CODEX_BRIDGE_ENV_VAR = "CODEX_BRIDGE";
export const CODEX_MODEL_ENV_VAR = "CODEX_MODEL";
export const CODEX_LOG_DIR_ENV_VAR = "CODEX_LOG_DIR";
export const CODEX_PROVIDER_ID_ENV_VAR = "CODEX_PROVIDER_ID";
export const CODEX_PROVIDER_NAME_ENV_VAR = "CODEX_PROVIDER_NAME";
export const CODEX_DISABLE_THINKING_ENV_VAR = "CODEX_DISABLE_THINKING";
export const NUWAX_MAX_OUTPUT_TOKENS_ENV_VAR = "NUWAX_MAX_OUTPUT_TOKENS";

// NUWAX_-prefixed aliases: the preferred spellings for the gateway variables
// above (CODEX_* stays supported). Mirrors the Rust binary's env_alias rules.
export const NUWAX_BASE_URL_ENV_VAR = "NUWAX_BASE_URL";
export const NUWAX_API_PROTOCOL_ENV_VAR = "NUWAX_API_PROTOCOL";
export const NUWAX_WIRE_API_ENV_VAR = "NUWAX_WIRE_API";
export const NUWAX_BRIDGE_ENV_VAR = "NUWAX_BRIDGE";
export const NUWAX_API_KEY_ENV_VAR = "NUWAX_API_KEY";
export const NUWAX_MODEL_ENV_VAR = "NUWAX_MODEL";
export const NUWAX_MODEL_CONTEXT_WINDOW_ENV_VAR = "NUWAX_MODEL_CONTEXT_WINDOW";
export const NUWAX_PROVIDER_ID_ENV_VAR = "NUWAX_PROVIDER_ID";
export const NUWAX_PROVIDER_NAME_ENV_VAR = "NUWAX_PROVIDER_NAME";
export const NUWAX_DISABLE_THINKING_ENV_VAR = "NUWAX_DISABLE_THINKING";

/**
 * One NUWAX_-prefixed / CODEX_-prefixed alias pair, resolved with the same
 * rules as the Rust binary's `utils/home-dir/src/env_alias.rs`:
 *
 * - only `NUWAX_*` set → it wins;
 * - only `CODEX_*` set → it wins (permanent compatibility);
 * - both set to the same value → fine (idempotent migration);
 * - both set with differing values → throws naming both variables: a
 *   split-brain configuration must not be silently resolved.
 *
 * Blank values count as unset. The returned `name` is the variable that
 * provided the value, so validation errors name what the user actually set.
 */
export interface ResolvedEnvVar {
    value: string | undefined;
    name: string;
}

export function resolveEnvAlias(nuwaxName: string, codexName: string): ResolvedEnvVar {
    return resolveEnvAliasFrom(process.env, nuwaxName, codexName);
}

/** Env-parameterized core for callers that take an injected environment
 * (e.g. `recoveryLimitsFromEnv`); same resolution rules. */
export function resolveEnvAliasFrom(
    env: NodeJS.ProcessEnv,
    nuwaxName: string,
    codexName: string,
): ResolvedEnvVar {
    // `|| undefined` folds blank values away so "   " counts as unset instead
    // of shadowing or conflicting with the other spelling.
    const nuwax = env[nuwaxName]?.trim() || undefined;
    const codex = env[codexName]?.trim() || undefined;
    if (nuwax !== undefined && codex !== undefined) {
        if (nuwax === codex) {
            return {value: nuwax, name: nuwaxName};
        }
        throw new Error(
            `${nuwaxName}="${nuwax}" and ${codexName}="${codex}" are both set but differ; ` +
                `set only one (NUWAX_* is the preferred spelling).`,
        );
    }
    return nuwax !== undefined
        ? {value: nuwax, name: nuwaxName}
        : {value: codex, name: codexName};
}

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

/** Transport selected for the environment-owned gateway; omitted preserves Codex's default. */
export type EnvBridge = "rig" | "native" | "genai";

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
        experimental_bridge?: EnvBridge;
        experimental_bearer_token?: string;
        max_output_tokens?: number;
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
    const baseUrl = resolveEnvAlias(NUWAX_BASE_URL_ENV_VAR, CODEX_BASE_URL_ENV_VAR);
    const bridge = parseEnvBridge(resolveEnvAlias(NUWAX_BRIDGE_ENV_VAR, CODEX_BRIDGE_ENV_VAR));
    if (!baseUrl.value) {
        if (bridge !== undefined) {
            throw new Error(`${NUWAX_BASE_URL_ENV_VAR}/${CODEX_BASE_URL_ENV_VAR} is required for the environment gateway when a bridge (${NUWAX_BRIDGE_ENV_VAR}/${CODEX_BRIDGE_ENV_VAR}) is set.`);
        }
        return null;
    }

    const apiProtocolRaw = resolveEnvAlias(NUWAX_API_PROTOCOL_ENV_VAR, CODEX_API_PROTOCOL_ENV_VAR);
    const apiProtocol = parseEnvApiProtocol(apiProtocolRaw);
    const wireRaw = resolveEnvAlias(NUWAX_WIRE_API_ENV_VAR, CODEX_WIRE_API_ENV_VAR);
    const openAiWire = parseEnvWireApi(wireRaw, apiProtocolRaw.value !== undefined);
    if (apiProtocol === "anthropic" && wireRaw.value !== undefined) {
        logger.log(
            `${wireRaw.name}="${wireRaw.value}" is ignored because ${apiProtocolRaw.name || CODEX_API_PROTOCOL_ENV_VAR}=anthropic selects the Anthropic protocol family`,
        );
    }
    const wireApi: GatewayWireApi = apiProtocol === "anthropic" ? "anthropic" : openAiWire;
    if (bridge === "native" && wireApi !== "responses") {
        throw new Error(`${CODEX_BRIDGE_ENV_VAR}/NUWAX_BRIDGE=native requires the OpenAI Responses protocol (api protocol "openai", wire "responses").`);
    }
    if (bridge === "genai" && wireApi === "responses") {
        throw new Error(`${CODEX_BRIDGE_ENV_VAR}/NUWAX_BRIDGE=genai requires the chat or anthropic protocol; responses is unsupported.`);
    }

    const providerName =
        resolveEnvAlias(NUWAX_PROVIDER_NAME_ENV_VAR, CODEX_PROVIDER_NAME_ENV_VAR).value
        || resolveEnvAlias(NUWAX_MODEL_ENV_VAR, CODEX_MODEL_ENV_VAR).value
        || "Custom Gateway";

    const headers: Record<string, string> = {"X-Client-Feature-ID": "codex"};

    const apiKey = readAnyApiKey();
    const maxOutputTokens = getEnvMaxOutputTokens();

    logger.log("Auto-configured gateway from env", {
        baseUrlConfigured: true,
        apiProtocol,
        wireApi,
        providerName,
        hasApiKey: !!apiKey,
    });

    return {
        modelProvider: getEnvProviderId(),
        config: {
            name: providerName,
            base_url: baseUrl.value!,
            http_headers: headers,
            wire_api: wireApi,
            ...(bridge === undefined ? {} : {experimental_bridge: bridge}),
            ...(apiKey ? {experimental_bearer_token: apiKey} : {}),
            ...(maxOutputTokens === undefined ? {} : {max_output_tokens: maxOutputTokens}),
        },
    };
}

// ---------------------------------------------------------------------------
// Model override
// ---------------------------------------------------------------------------

/**
 * If `CODEX_MODEL` (alias `NUWAX_MODEL`) is set in env, returns it. Used to
 * override codex's default model selection when using a custom gateway.
 */
export function getEnvModel(): string | undefined {
    return resolveEnvAlias(NUWAX_MODEL_ENV_VAR, CODEX_MODEL_ENV_VAR).value || undefined;
}

/**
 * If `CODEX_MODEL_CONTEXT_WINDOW` (alias `NUWAX_MODEL_CONTEXT_WINDOW`) is set,
 * returns it parsed as a number. Used to inform codex of a custom model's
 * context window size.
 */
export function getEnvContextWindow(): number | undefined {
    const raw = resolveEnvAlias(NUWAX_MODEL_CONTEXT_WINDOW_ENV_VAR, "CODEX_MODEL_CONTEXT_WINDOW").value;
    if (!raw) return undefined;
    const n = parseInt(raw, 10);
    return isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Parses `NUWAX_MAX_OUTPUT_TOKENS` — the per-generation output cap, named after
 * the harness CLI group so one value serves both entries. Invalid values fail
 * fast: a cap that silently never applies is only noticed on the invoice.
 */
export function getEnvMaxOutputTokens(): number | undefined {
    const raw = process.env[NUWAX_MAX_OUTPUT_TOKENS_ENV_VAR]?.trim();
    if (raw === undefined || raw === "") return undefined;
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid ${NUWAX_MAX_OUTPUT_TOKENS_ENV_VAR}="${raw}"; expected a positive integer.`);
    }
    return n;
}

/**
 * The environment for the app-server child: everything except the NUWAX_*
 * variables this adapter consumed into the gateway entry. The engine's own
 * `NUWAX_*` startup-group reader fails fast on orphans (e.g. a lone
 * NUWAX_BASE_URL or NUWAX_BRIDGE), so every consumed alias is stripped —
 * the same consume-and-strip pattern NUWAX_MAX_OUTPUT_TOKENS established.
 */
export function childProcessEnv(): NodeJS.ProcessEnv {
    const env = {...process.env};
    for (const name of CONSUMED_NUWAX_ENV_VARS) {
        delete env[name];
    }
    return env;
}

/** NUWAX_* aliases consumed into the gateway config; never forwarded raw. */
const CONSUMED_NUWAX_ENV_VARS: readonly string[] = [
    NUWAX_MAX_OUTPUT_TOKENS_ENV_VAR,
    NUWAX_BASE_URL_ENV_VAR,
    NUWAX_API_PROTOCOL_ENV_VAR,
    NUWAX_WIRE_API_ENV_VAR,
    NUWAX_API_KEY_ENV_VAR,
    NUWAX_BRIDGE_ENV_VAR,
];

/** Returns the custom provider id from env, or the default "custom-gateway". */
export function getEnvProviderId(): string {
    return (
        resolveEnvAlias(NUWAX_PROVIDER_ID_ENV_VAR, CODEX_PROVIDER_ID_ENV_VAR).value
        || CUSTOM_GATEWAY_ID
    );
}

/** Returns true when CODEX_DISABLE_THINKING (alias NUWAX_DISABLE_THINKING) is truthy. */
export function isThinkingDisabled(): boolean {
    const raw = resolveEnvAlias(NUWAX_DISABLE_THINKING_ENV_VAR, CODEX_DISABLE_THINKING_ENV_VAR)
        .value
        ?.toLowerCase();
    return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try `NUWAX_API_KEY`, then `CODEX_API_KEY`, then fall back to
 * `OPENAI_API_KEY`. Returns `undefined` when none is set (callers decide
 * whether this is fatal).
 */
function readAnyApiKey(): string | undefined {
    for (const envVar of [NUWAX_API_KEY_ENV_VAR, CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR]) {
        const value = process.env[envVar]?.trim();
        if (value) {
            return value;
        }
    }
    return undefined;
}

/**
 * Parses the api protocol variable. Unset defaults to the OpenAI protocol
 * family. An unknown value is fatal so a typo cannot silently select the
 * wrong family; the error names the variable that was actually set.
 */
function parseEnvApiProtocol(raw: ResolvedEnvVar): EnvApiProtocol {
    if (raw.value === undefined) {
        return "openai";
    }
    if (raw.value === "openai" || raw.value === "anthropic") {
        return raw.value;
    }
    throw new Error(
        `Invalid ${raw.name}; expected "openai" or "anthropic".`,
    );
}

/**
 * Parses the wire-protocol variable, the wire variant within the OpenAI
 * protocol family. Unset defaults to "responses"; an unknown value (including
 * "anthropic") is fatal — select the Anthropic family with the api protocol
 * variable.
 */
function parseEnvWireApi(raw: ResolvedEnvVar, apiProtocolSet: boolean): EnvWireApi {
    if (raw.value === undefined) {
        return "responses";
    }
    if (raw.value === "responses" || raw.value === "chat") {
        return raw.value;
    }
    throw new Error(
        `Invalid ${raw.name}; expected "responses" or "chat" within the OpenAI family` +
            (apiProtocolSet ? "" : `, or set ${CODEX_API_PROTOCOL_ENV_VAR}/NUWAX_API_PROTOCOL=anthropic for the Anthropic protocol`),
    );
}

/** Either spelling owns this gateway; the NUWAX alias is consumed and stripped before the engine sees it. */
function parseEnvBridge(raw: ResolvedEnvVar): EnvBridge | undefined {
    if (raw.value === undefined) return undefined;
    if (raw.value === "rig" || raw.value === "native" || raw.value === "genai") return raw.value;
    throw new Error(`Invalid ${raw.name}; expected "rig", "native", or "genai".`);
}
