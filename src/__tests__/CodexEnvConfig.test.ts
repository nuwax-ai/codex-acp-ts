import {afterEach, describe, expect, it} from "vitest";
import {CODEX_API_KEY_ENV_VAR} from "../CodexAuthMethod";
import {
    childProcessEnv,
    CODEX_API_PROTOCOL_ENV_VAR,
    CODEX_BASE_URL_ENV_VAR,
    CODEX_BRIDGE_ENV_VAR,
    CODEX_MODEL_REASONING_EFFORT_ENV_VAR,
    CODEX_WIRE_API_ENV_VAR,
    getEnvContextWindow,
    getEnvMaxOutputTokens,
    getEnvModel,
    getEnvProviderId,
    getEnvReasoningEffort,
    getEnvReasoningEffortLevels,
    isThinkingDisabled,
    NUWAX_API_PROTOCOL_ENV_VAR,
    NUWAX_BASE_URL_ENV_VAR,
    NUWAX_BRIDGE_ENV_VAR,
    NUWAX_MAX_OUTPUT_TOKENS_ENV_VAR,
    NUWAX_MODEL_CONTEXT_WINDOW_ENV_VAR,
    NUWAX_MODEL_ENV_VAR,
    NUWAX_MODEL_REASONING_EFFORT_ENV_VAR,
    NUWAX_REASONING_EFFORT_LEVELS_ENV_VAR,
    NUWAX_WIRE_API_ENV_VAR,
    readGatewayConfigFromEnv,
    resolveEnvAlias,
} from "../CodexEnvConfig";

const ENV_VARS = [
    CODEX_BASE_URL_ENV_VAR,
    CODEX_BRIDGE_ENV_VAR,
    CODEX_API_PROTOCOL_ENV_VAR,
    CODEX_WIRE_API_ENV_VAR,
    CODEX_API_KEY_ENV_VAR,
    "OPENAI_API_KEY",
    NUWAX_BASE_URL_ENV_VAR,
    NUWAX_BRIDGE_ENV_VAR,
    NUWAX_API_PROTOCOL_ENV_VAR,
    NUWAX_WIRE_API_ENV_VAR,
    "NUWAX_API_KEY",
    "NUWAX_PROVIDER_ID",
    "NUWAX_PROVIDER_NAME",
    "NUWAX_DISABLE_THINKING",
    "NUWAX_MODEL_REASONING_EFFORT",
    "CODEX_MODEL_REASONING_EFFORT",
    "NUWAX_REASONING_EFFORT_LEVELS",
    NUWAX_MODEL_ENV_VAR,
    NUWAX_MODEL_CONTEXT_WINDOW_ENV_VAR,
    NUWAX_MAX_OUTPUT_TOKENS_ENV_VAR,
    "CODEX_MODEL",
    "CODEX_PROVIDER_ID",
];

function withEnv(overrides: Record<string, string>, run: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const name of ENV_VARS) {
        saved[name] = process.env[name];
        const value = overrides[name];
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }
    try {
        run();
    } finally {
        for (const name of ENV_VARS) {
            const value = saved[name];
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
    }
}

describe("readGatewayConfigFromEnv", () => {
    afterEach(() => {
        for (const name of ENV_VARS) {
            delete process.env[name];
        }
    });

    it("returns null without CODEX_BASE_URL", () => {
        withEnv({}, () => {
            expect(readGatewayConfigFromEnv()).toBeNull();
        });
    });

    it("defaults to the OpenAI family with the responses wire when both are unset", () => {
        withEnv({[CODEX_BASE_URL_ENV_VAR]: "https://api.example.com"}, () => {
            expect(readGatewayConfigFromEnv()?.config.wire_api).toBe("responses");
            expect(readGatewayConfigFromEnv()?.config).not.toHaveProperty("experimental_bridge");
        });
    });

    it.each([
        ["rig", "openai", "responses"],
        ["rig", "openai", "chat"],
        ["rig", "anthropic", "responses"],
        ["native", "openai", "responses"],
        ["genai", "openai", "chat"],
        ["genai", "anthropic", "responses"],
    ])("selects bridge %s for %s/%s", (bridge, protocol, wire) => {
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [CODEX_BRIDGE_ENV_VAR]: ` ${bridge} `,
            [CODEX_API_PROTOCOL_ENV_VAR]: protocol,
            [CODEX_WIRE_API_ENV_VAR]: wire,
        }, () => {
            expect(readGatewayConfigFromEnv()?.config.experimental_bridge).toBe(bridge);
        });
    });

    it.each(["rig", "native", "genai"])("rejects orphan bridge %s without a gateway", bridge => {
        withEnv({[CODEX_BRIDGE_ENV_VAR]: bridge}, () => {
            expect(() => readGatewayConfigFromEnv()).toThrow(/is required for the environment gateway/);
        });
    });

    it.each([
        ["native", "openai", "chat"],
        ["native", "anthropic", "responses"],
        ["genai", "openai", "responses"],
        ["invalid-secret-bridge", "openai", "responses"],
    ])("rejects unsupported bridge/protocol %s/%s/%s without exposing credentials", (bridge, protocol, wire) => {
        const sensitiveUrl = "https://user:password@gateway.example/private-token";
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: sensitiveUrl,
            [CODEX_BRIDGE_ENV_VAR]: bridge,
            [CODEX_API_PROTOCOL_ENV_VAR]: protocol,
            [CODEX_WIRE_API_ENV_VAR]: wire,
            [CODEX_API_KEY_ENV_VAR]: "secret-api-key",
        }, () => {
            let error: unknown;
            try { readGatewayConfigFromEnv(); } catch (caught) { error = caught; }
            expect(error).toBeInstanceOf(Error);
            const message = (error as Error).message;
            expect(message).toContain("CODEX_BRIDGE");
            expect(message).not.toContain(sensitiveUrl);
            expect(message).not.toContain("secret-api-key");
                    });
    });

    it("treats NUWAX_BRIDGE as the alias of CODEX_BRIDGE (semantics change: it used to be deliberately ignored)", () => {
        // NUWAX_BRIDGE alone selects the bridge; the adapter consumes it into
        // the gateway entry and strips it from the child env, so the engine's
        // own NUWAX_* group never sees an orphan.
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
            NUWAX_BRIDGE: "native",
            [CODEX_WIRE_API_ENV_VAR]: "responses",
        }, () => {
            expect(readGatewayConfigFromEnv()?.config.experimental_bridge).toBe("native");
        });
        // Same value through both spellings is idempotent.
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [CODEX_BRIDGE_ENV_VAR]: "rig",
            NUWAX_BRIDGE: "rig",
        }, () => {
            expect(readGatewayConfigFromEnv()?.config.experimental_bridge).toBe("rig");
        });
        // Differing values fail fast naming both spellings.
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [CODEX_BRIDGE_ENV_VAR]: "rig",
            NUWAX_BRIDGE: "native",
        }, () => {
            expect(() => readGatewayConfigFromEnv()).toThrow(/NUWAX_BRIDGE.*CODEX_BRIDGE.*both set but differ/s);
        });
    });

    it("selects the chat wire within the OpenAI family", () => {
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [CODEX_WIRE_API_ENV_VAR]: "chat",
        }, () => {
            expect(readGatewayConfigFromEnv()?.config.wire_api).toBe("chat");
        });
    });

    it("selects the Anthropic protocol family via CODEX_API_PROTOCOL", () => {
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [CODEX_API_PROTOCOL_ENV_VAR]: "anthropic",
        }, () => {
            expect(readGatewayConfigFromEnv()?.config.wire_api).toBe("anthropic");
        });
    });

    it("ignores the OpenAI wire setting when the Anthropic family is selected", () => {
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [CODEX_API_PROTOCOL_ENV_VAR]: "anthropic",
            [CODEX_WIRE_API_ENV_VAR]: "chat",
        }, () => {
            expect(readGatewayConfigFromEnv()?.config.wire_api).toBe("anthropic");
        });
    });

    it("fails fast on an unknown protocol family", () => {
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [CODEX_API_PROTOCOL_ENV_VAR]: "antrophic",
        }, () => {
            expect(() => readGatewayConfigFromEnv()).toThrow(/CODEX_API_PROTOCOL/);
        });
    });

    it("fails fast on an unknown wire value instead of silently switching protocols", () => {
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [CODEX_WIRE_API_ENV_VAR]: "anthrpic",
        }, () => {
            expect(() => readGatewayConfigFromEnv()).toThrow(/CODEX_WIRE_API/);
        });
    });

    it("rejects the anthropic wire value on the wire var; it belongs to the protocol var", () => {
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [CODEX_WIRE_API_ENV_VAR]: "anthropic",
        }, () => {
            expect(() => readGatewayConfigFromEnv()).toThrow(/CODEX_API_PROTOCOL/);
        });
    });

    it("carries NUWAX_MAX_OUTPUT_TOKENS into the gateway provider entry", () => {
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [NUWAX_MAX_OUTPUT_TOKENS_ENV_VAR]: "4096",
        }, () => {
            expect(readGatewayConfigFromEnv()?.config.max_output_tokens).toBe(4096);
            expect(getEnvMaxOutputTokens()).toBe(4096);
        });
    });

    it("omits max_output_tokens when the cap variable is unset", () => {
        withEnv({[CODEX_BASE_URL_ENV_VAR]: "https://api.example.com"}, () => {
            expect(readGatewayConfigFromEnv()?.config).not.toHaveProperty("max_output_tokens");
            expect(getEnvMaxOutputTokens()).toBeUndefined();
        });
    });

    it.each(["abc", "0", "-5", "4.5", "4096 tokens"])(
        "fails fast on an invalid NUWAX_MAX_OUTPUT_TOKENS value %s",
        value => {
            withEnv({
                [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
                [NUWAX_MAX_OUTPUT_TOKENS_ENV_VAR]: value,
            }, () => {
                expect(() => readGatewayConfigFromEnv()).toThrow(/NUWAX_MAX_OUTPUT_TOKENS/);
            });
        },
    );

    it("passes the API key through as the bearer token", () => {
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [CODEX_API_KEY_ENV_VAR]: "sk-test",
        }, () => {
            expect(readGatewayConfigFromEnv()?.config.experimental_bearer_token).toBe("sk-test");
        });
    });
});

describe("NUWAX_* aliases for the ACP gateway variables", () => {
    afterEach(() => {
        for (const name of ENV_VARS) {
            delete process.env[name];
        }
    });

    it("activates the gateway from NUWAX_* spellings alone", () => {
        withEnv({
            [NUWAX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [NUWAX_API_PROTOCOL_ENV_VAR]: "anthropic",
            "NUWAX_API_KEY": "sk-nuwax",
            [NUWAX_MODEL_ENV_VAR]: "GLM-5.3-Flash",
        }, () => {
            const config = readGatewayConfigFromEnv();
            expect(config?.config.wire_api).toBe("anthropic");
            expect(config?.config.experimental_bearer_token).toBe("sk-nuwax");
            expect(config?.config.name).toBe("GLM-5.3-Flash");
            expect(getEnvModel()).toBe("GLM-5.3-Flash");
        });
    });

    it("keeps CODEX_* working when NUWAX_* is unset", () => {
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [CODEX_WIRE_API_ENV_VAR]: "chat",
        }, () => {
            expect(readGatewayConfigFromEnv()?.config.wire_api).toBe("chat");
        });
    });

    it("treats both spellings with the same value as idempotent", () => {
        withEnv({
            [NUWAX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
        }, () => {
            expect(readGatewayConfigFromEnv()?.config.base_url).toBe("https://api.example.com");
        });
    });

    it("fails fast naming both spellings when they differ", () => {
        withEnv({
            [NUWAX_BASE_URL_ENV_VAR]: "https://a.example.com",
            [CODEX_BASE_URL_ENV_VAR]: "https://b.example.com",
        }, () => {
            expect(() => readGatewayConfigFromEnv()).toThrow(
                /NUWAX_BASE_URL="https:\/\/a.example.com" and CODEX_BASE_URL="https:\/\/b.example.com" are both set but differ/,
            );
        });
    });

    it("blank NUWAX_* does not shadow a CODEX_* value", () => {
        withEnv({
            [NUWAX_BASE_URL_ENV_VAR]: "   ",
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
        }, () => {
            expect(readGatewayConfigFromEnv()?.config.base_url).toBe("https://api.example.com");
        });
    });

    it("names the variable the user actually set in validation errors", () => {
        withEnv({
            [NUWAX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [NUWAX_API_PROTOCOL_ENV_VAR]: "antrophic",
        }, () => {
            expect(() => readGatewayConfigFromEnv()).toThrow(/Invalid NUWAX_API_PROTOCOL/);
        });
    });

    it("aliases the model context window, provider id and thinking switch", () => {
        withEnv({
            [NUWAX_MODEL_CONTEXT_WINDOW_ENV_VAR]: "1000000",
            "NUWAX_PROVIDER_ID": "glm",
            "NUWAX_DISABLE_THINKING": "true",
        }, () => {
            expect(getEnvContextWindow()).toBe(1000000);
            expect(getEnvProviderId()).toBe("glm");
            expect(isThinkingDisabled()).toBe(true);
        });
    });

    it("strips the consumed NUWAX_* aliases from the app-server child env", () => {
        withEnv({
            [NUWAX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [NUWAX_WIRE_API_ENV_VAR]: "chat",
            "NUWAX_API_KEY": "sk-nuwax",
            NUWAX_BRIDGE: "rig",
            [NUWAX_API_PROTOCOL_ENV_VAR]: "openai",
            [NUWAX_MAX_OUTPUT_TOKENS_ENV_VAR]: "4096",
            [NUWAX_MODEL_CONTEXT_WINDOW_ENV_VAR]: "1000000",
        }, () => {
            const child = childProcessEnv();
            // Consumed by the adapter into the gateway entry: never forwarded.
            expect(child[NUWAX_BASE_URL_ENV_VAR]).toBeUndefined();
            expect(child[NUWAX_WIRE_API_ENV_VAR]).toBeUndefined();
            expect(child["NUWAX_API_KEY"]).toBeUndefined();
            expect(child[NUWAX_BRIDGE_ENV_VAR]).toBeUndefined();
            expect(child[NUWAX_API_PROTOCOL_ENV_VAR]).toBeUndefined();
            expect(child[NUWAX_MAX_OUTPUT_TOKENS_ENV_VAR]).toBeUndefined();
            // Not consumed as gateway config: forwarded so the engine's own
            // NUWAX_MODEL_CONTEXT_WINDOW seed applies the same value.
            expect(child[NUWAX_MODEL_CONTEXT_WINDOW_ENV_VAR]).toBe("1000000");
        });
    });

    it("reads the effort the operator asked for through either alias", () => {
        withEnv({[NUWAX_MODEL_REASONING_EFFORT_ENV_VAR]: "high"}, () => {
            expect(getEnvReasoningEffort()).toBe("high");
        });
        withEnv({[CODEX_MODEL_REASONING_EFFORT_ENV_VAR]: "low"}, () => {
            expect(getEnvReasoningEffort()).toBe("low");
        });
        withEnv({}, () => {
            expect(getEnvReasoningEffort()).toBeUndefined();
        });
    });

    it("shape-parses the declared tiers without judging which words are tiers", () => {
        withEnv({[NUWAX_REASONING_EFFORT_LEVELS_ENV_VAR]: " Low , high ,low,"}, () => {
            expect(getEnvReasoningEffortLevels()).toEqual(["low", "high"]);
        });
        withEnv({}, () => {
            expect(getEnvReasoningEffortLevels()).toBeUndefined();
        });
        // An unspellable word is left for the engine to refuse; this layer only
        // reads the shape, so it must not invent a second vocabulary.
        withEnv({[NUWAX_REASONING_EFFORT_LEVELS_ENV_VAR]: "low,hih"}, () => {
            expect(getEnvReasoningEffortLevels()).toEqual(["low", "hih"]);
        });
    });

    it("refuses a set-but-empty tier list rather than reading it as no tiers", () => {
        for (const value of ["", "   ", ",", " , ,"]) {
            withEnv({[NUWAX_REASONING_EFFORT_LEVELS_ENV_VAR]: value}, () => {
                expect(() => getEnvReasoningEffortLevels()).toThrow(/NUWAX_REASONING_EFFORT_LEVELS/);
            });
        }
    });

    it("folds a blank effort away, as every alias pair here does", () => {
        // A blank alias must not shadow the other spelling, so it counts as
        // unset rather than as a value the gateway would refuse.
        withEnv({[NUWAX_MODEL_REASONING_EFFORT_ENV_VAR]: "   "}, () => {
            expect(getEnvReasoningEffort()).toBeUndefined();
        });
        withEnv({
            [NUWAX_MODEL_REASONING_EFFORT_ENV_VAR]: "  ",
            [CODEX_MODEL_REASONING_EFFORT_ENV_VAR]: "high",
        }, () => {
            expect(getEnvReasoningEffort()).toBe("high");
        });
    });

    it("forwards the declared tiers to the app-server child, which enforces them", () => {
        withEnv({
            [NUWAX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [NUWAX_REASONING_EFFORT_LEVELS_ENV_VAR]: "low,high,max",
        }, () => {
            const child = childProcessEnv();
            expect(child[NUWAX_REASONING_EFFORT_LEVELS_ENV_VAR]).toBe("low,high,max");
        });
    });

    it("resolveEnvAlias prefers NUWAX and reports the winning name", () => {
        withEnv({[NUWAX_WIRE_API_ENV_VAR]: "chat"}, () => {
            expect(resolveEnvAlias(NUWAX_WIRE_API_ENV_VAR, CODEX_WIRE_API_ENV_VAR)).toEqual({
                value: "chat",
                name: NUWAX_WIRE_API_ENV_VAR,
            });
        });
        withEnv({[CODEX_WIRE_API_ENV_VAR]: "chat"}, () => {
            expect(resolveEnvAlias(NUWAX_WIRE_API_ENV_VAR, CODEX_WIRE_API_ENV_VAR)).toEqual({
                value: "chat",
                name: CODEX_WIRE_API_ENV_VAR,
            });
        });
    });
});
