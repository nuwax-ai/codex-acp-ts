import {afterEach, describe, expect, it} from "vitest";
import {CODEX_API_KEY_ENV_VAR} from "../CodexAuthMethod";
import {
    CODEX_API_PROTOCOL_ENV_VAR,
    CODEX_BASE_URL_ENV_VAR,
    CODEX_WIRE_API_ENV_VAR,
    readGatewayConfigFromEnv,
} from "../CodexEnvConfig";

const ENV_VARS = [
    CODEX_BASE_URL_ENV_VAR,
    CODEX_API_PROTOCOL_ENV_VAR,
    CODEX_WIRE_API_ENV_VAR,
    CODEX_API_KEY_ENV_VAR,
    "OPENAI_API_KEY",
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

    it("passes the API key through as the bearer token", () => {
        withEnv({
            [CODEX_BASE_URL_ENV_VAR]: "https://api.example.com",
            [CODEX_API_KEY_ENV_VAR]: "sk-test",
        }, () => {
            expect(readGatewayConfigFromEnv()?.config.experimental_bearer_token).toBe("sk-test");
        });
    });
});
