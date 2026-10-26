import {afterEach, describe, expect, it} from "vitest";
import {CODEX_API_KEY_ENV_VAR} from "../CodexAuthMethod";
import {
    CODEX_API_PROTOCOL_ENV_VAR,
    CODEX_BASE_URL_ENV_VAR,
    CODEX_BRIDGE_ENV_VAR,
    CODEX_WIRE_API_ENV_VAR,
    getEnvMaxOutputTokens,
    NUWAX_MAX_OUTPUT_TOKENS_ENV_VAR,
    readGatewayConfigFromEnv,
} from "../CodexEnvConfig";

const ENV_VARS = [
    CODEX_BASE_URL_ENV_VAR,
    CODEX_BRIDGE_ENV_VAR,
    CODEX_API_PROTOCOL_ENV_VAR,
    CODEX_WIRE_API_ENV_VAR,
    CODEX_API_KEY_ENV_VAR,
    "OPENAI_API_KEY",
    "NUWAX_BRIDGE",
    NUWAX_MAX_OUTPUT_TOKENS_ENV_VAR,
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
            expect(() => readGatewayConfigFromEnv()).toThrow(/CODEX_BRIDGE requires CODEX_BASE_URL/);
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
            expect(message).not.toContain("invalid-secret-bridge");
        });
    });

    it("does not treat NUWAX_BRIDGE as an override for the ACP gateway", () => {
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [CODEX_BRIDGE_ENV_VAR]: "rig",
            NUWAX_BRIDGE: "native",
        }, () => {
            expect(readGatewayConfigFromEnv()?.config.experimental_bridge).toBe("rig");
        });
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
            NUWAX_BRIDGE: "native",
        }, () => {
            expect(readGatewayConfigFromEnv()?.config).not.toHaveProperty("experimental_bridge");
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
