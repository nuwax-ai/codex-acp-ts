import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {PROTOCOL_VERSION} from "@agentclientprotocol/sdk";
import {createCodexMockTestFixture, stubGatewayModelListing} from "../acp-test-utils";
import {CUSTOM_GATEWAY_PROVIDER_ID, OPENAI_PROVIDER_ID} from "../../CodexAcpClient";
import {TitleGenerator} from "../../TitleGenerator";

stubGatewayModelListing(["model-id"]);

const ENV_VARS = [
    "CODEX_BASE_URL", "CODEX_API_PROTOCOL", "CODEX_WIRE_API", "CODEX_BRIDGE",
    "CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_PROVIDER_ID", "CODEX_PROVIDER_NAME",
    "CODEX_MODEL", "CODEX_MODEL_CONTEXT_WINDOW", "NUWAX_BRIDGE",
];

describe("environment gateway bridge routing", () => {
    beforeEach(() => {
        for (const name of ENV_VARS) vi.stubEnv(name, undefined);
        vi.stubEnv("CODEX_BASE_URL", "https://gateway.example/v1");
        vi.stubEnv("CODEX_API_KEY", "secret-test-token");
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it.each([
        [undefined, "openai", "responses"],
        ["rig", "openai", "responses"],
        ["rig", "openai", "chat"],
        ["rig", "anthropic", "anthropic"],
        ["native", "openai", "responses"],
        ["genai", "openai", "chat"],
        ["genai", "anthropic", "anthropic"],
    ])("keeps %s/%s/%s through initialize, environment authorization and thread/start", async (bridge, protocol, wire) => {
        vi.stubEnv("CODEX_BRIDGE", bridge);
        vi.stubEnv("CODEX_API_PROTOCOL", protocol);
        vi.stubEnv("CODEX_WIRE_API", wire === "anthropic" ? undefined : wire);
        vi.stubEnv("NUWAX_BRIDGE", bridge === "native" ? "rig" : "native");
        const fixture = createCodexMockTestFixture();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        const initialize = vi.spyOn(appServer, "initialize").mockResolvedValue({} as never);
        const start = vi.spyOn(appServer, "threadStart").mockRejectedValue(new Error("captured thread/start"));

        await client.initialize({});
        expect(initialize).toHaveBeenCalledOnce();
        expect((await client.readAuthRequirement()).required).toBe(false);
        expect(client.getAuthGatewayProviderName()).toBe("Custom Gateway");
        await expect(client.newSession({cwd: "/workspace", mcpServers: []})).rejects.toThrow("captured thread/start");

        const params = start.mock.calls[0]![0];
        expect(params.modelProvider).toBe(CUSTOM_GATEWAY_PROVIDER_ID);
        expect(params.config).toMatchObject({
            model_providers: {
                [CUSTOM_GATEWAY_PROVIDER_ID]: {
                    base_url: "https://gateway.example/v1",
                    wire_api: wire,
                    experimental_bearer_token: "secret-test-token",
                },
            },
        });
        const provider = (params.config!["model_providers"] as Record<string, Record<string, unknown>>)[CUSTOM_GATEWAY_PROVIDER_ID]!;
        if (bridge === undefined) {
            expect(provider).not.toHaveProperty("experimental_bridge");
        } else {
            expect(provider["experimental_bridge"]).toBe(bridge);
        }
    });

    it("does not leak the environment bridge or token into an explicit providers/set replacement", async () => {
        vi.stubEnv("CODEX_BRIDGE", "native");
        vi.stubEnv("NUWAX_BRIDGE", "native");
        const fixture = createCodexMockTestFixture();
        const client = fixture.getCodexAcpClient();
        const start = vi.spyOn(fixture.getCodexAppServerClient(), "threadStart")
            .mockRejectedValue(new Error("captured replacement"));

        await fixture.getCodexAcpAgent().setProvider({
            providerId: OPENAI_PROVIDER_ID,
            apiType: "anthropic",
            baseUrl: "https://replacement.example/anthropic",
            headers: {"x-api-key": "replacement-token"},
        });
        expect((await client.readAuthRequirement()).required).toBe(false);
        await expect(client.newSession({cwd: "/workspace", mcpServers: []})).rejects.toThrow("captured replacement");
        const provider = (start.mock.calls[0]![0].config!["model_providers"] as Record<string, Record<string, unknown>>)[CUSTOM_GATEWAY_PROVIDER_ID]!;
        expect(provider).toMatchObject({
            wire_api: "anthropic",
            base_url: "https://replacement.example/anthropic",
            http_headers: {"x-api-key": "replacement-token"},
        });
        expect(provider).not.toHaveProperty("experimental_bridge");
        expect(provider).not.toHaveProperty("experimental_bearer_token");
    });

    it.each([
        ["rig", "openai", "responses"],
        ["rig", "openai", "chat"],
        ["rig", "anthropic", "anthropic"],
        ["native", "openai", "responses"],
        ["genai", "openai", "chat"],
        ["genai", "anthropic", "anthropic"],
    ])("keeps environment gateway credentials and bridge in hidden title sampling: %s/%s/%s", async (bridge, protocol, wire) => {
        vi.stubEnv("CODEX_BRIDGE", bridge);
        vi.stubEnv("CODEX_API_PROTOCOL", protocol);
        vi.stubEnv("CODEX_WIRE_API", wire === "anthropic" ? undefined : wire);
        const fixture = createCodexMockTestFixture();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        const start = vi.spyOn(appServer, "threadStart").mockResolvedValue({thread: {id: "title-thread"}} as never);
        const turn = vi.spyOn(appServer, "runTurn").mockResolvedValue({turn: {items: []}} as never);
        const generator = new TitleGenerator(appServer, "main-thread", "/workspace", () => "unset", () => ({
            provider: client.getModelProvider(),
            model: "active-domestic-model",
            config: client.getModelProviderOverrides(client.getModelProvider()),
        }));

        generator.onTurnCompleted("Continue our model compatibility check");
        await generator.waitForIdle(1_000);
        expect(start).toHaveBeenCalledWith(expect.objectContaining({
            ephemeral: true,
            modelProvider: CUSTOM_GATEWAY_PROVIDER_ID,
            config: {model_providers: {[CUSTOM_GATEWAY_PROVIDER_ID]: {
                name: "Custom Gateway",
                base_url: "https://gateway.example/v1",
                wire_api: wire,
                experimental_bridge: bridge,
                experimental_bearer_token: "secret-test-token",
                http_headers: {"X-Client-Feature-ID": "codex"},
            }}},
        }));
        expect(turn).toHaveBeenCalledWith(expect.objectContaining({threadId: "title-thread", model: "active-domestic-model"}));
    });

    it("does not carry the environment bridge into explicit gateway authentication", async () => {
        vi.stubEnv("CODEX_BRIDGE", "native");
        const fixture = createCodexMockTestFixture();
        const client = fixture.getCodexAcpClient();
        const start = vi.spyOn(fixture.getCodexAppServerClient(), "threadStart")
            .mockRejectedValue(new Error("captured authentication replacement"));

        await client.authenticate({
            methodId: "gateway",
            _meta: {gateway: {baseUrl: "https://auth.example/v1", providerName: "Explicit gateway"}},
        });
        expect((await client.readAuthRequirement()).required).toBe(false);
        await expect(client.newSession({cwd: "/workspace", mcpServers: []})).rejects.toThrow("captured authentication replacement");
        const provider = (start.mock.calls[0]![0].config!["model_providers"] as Record<string, Record<string, unknown>>)[CUSTOM_GATEWAY_PROVIDER_ID]!;
        expect(provider["base_url"]).toBe("https://auth.example/v1");
        expect(provider).not.toHaveProperty("experimental_bridge");
    });
});
