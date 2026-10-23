import {describe, expect, it, vi} from "vitest";
import {TitleGenerator} from "../TitleGenerator";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import {deferred} from "./acp-test-utils";

function createGenerator(client: Partial<CodexAppServerClient>) {
    return new TitleGenerator(client as CodexAppServerClient, "thread-id", "/test/cwd", () => "unset", () => ({provider: "openai", model: "gpt-6-sol"}));
}

describe("TitleGenerator.waitForIdle", () => {
    it("returns immediately when nothing is generating", async () => {
        const generator = createGenerator({});

        await expect(generator.waitForIdle(50)).resolves.toBeUndefined();
    });

    it("waits for the rename echo notification before settling", async () => {
        const turn = deferred<{turn: {items: {type: string; text: string}[]}}>();
        const threadSetName = vi.fn().mockResolvedValue({});
        const generator = createGenerator({
            threadStart: vi.fn().mockResolvedValue({thread: {id: "ephemeral"}}),
            runTurn: vi.fn().mockReturnValue(turn.promise),
            threadSetName,
        } as unknown as Partial<CodexAppServerClient>);

        generator.onTurnCompleted("hello");
        let settled = false;
        const idle = generator.waitForIdle(5_000).then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        turn.resolve({turn: {items: [{type: "agentMessage", text: '{"title":"A short title"}'}]}});
        // Flush the microtask chain (extract title -> threadSetName -> start
        // waiting for the echo) without resolving the echo itself yet.
        for (let i = 0; i < 10; i++) {
            await Promise.resolve();
        }
        expect(threadSetName).toHaveBeenCalledWith({threadId: "thread-id", name: "A short title"});
        expect(settled).toBe(false);

        // The thread/name/updated notification for this rename arrives.
        generator.observeRename();
        await idle;
        expect(settled).toBe(true);
    });

    it("gives up after the timeout rather than holding the caller open", async () => {
        const generator = createGenerator({
            threadStart: vi.fn().mockResolvedValue({thread: {id: "ephemeral"}}),
            runTurn: vi.fn().mockReturnValue(new Promise(() => {})),
            threadSetName: vi.fn(),
        } as unknown as Partial<CodexAppServerClient>);

        generator.onTurnCompleted("hello");

        await expect(generator.waitForIdle(20)).resolves.toBeUndefined();
    });

    it("stops waiting once a failed generation has settled", async () => {
        const generator = createGenerator({
            threadStart: vi.fn().mockRejectedValue(new Error("no ephemeral threads")),
            runTurn: vi.fn(),
            threadSetName: vi.fn(),
        } as unknown as Partial<CodexAppServerClient>);

        generator.onTurnCompleted("hello");

        await expect(generator.waitForIdle(5_000)).resolves.toBeUndefined();
    });
});

describe("TitleGenerator provider routing", () => {
    it("uses the active model when a gateway overrides the built-in OpenAI provider id", async () => {
        const threadStart = vi.fn().mockResolvedValue({thread: {id: "ephemeral"}});
        const runTurn = vi.fn().mockResolvedValue({turn: {items: []}});
        const generator = new TitleGenerator({threadStart, runTurn} as unknown as CodexAppServerClient,
            "main", "/test/cwd", () => "unset", () => ({
                provider: "openai",
                model: "custom-model",
                config: {model_providers: {openai: {base_url: "https://gateway.example/v1", experimental_bridge: "native"}}},
            }));
        generator.onTurnCompleted("Keep the deployment's selected model");
        await generator.waitForIdle(1_000);
        expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({model: "custom-model"}));
    });

    it("snapshots the complete provider definition before hidden thread creation", async () => {
        const thread = deferred<{thread: {id: string}}>();
        const threadStart = vi.fn().mockReturnValue(thread.promise);
        const runTurn = vi.fn().mockResolvedValue({turn: {items: []}});
        const config = {model_providers: {gateway: {
            base_url: "https://gateway.example/v1",
            wire_api: "responses",
            experimental_bridge: "native",
            experimental_bearer_token: "private-token",
            query_params: {"api-version": "2026-10-22"},
            http_headers: {"x-custom-auth": "private-header"},
        }}};
        const generator = new TitleGenerator({threadStart, runTurn} as unknown as CodexAppServerClient,
            "main", "/test/cwd", () => "unset", () => ({provider: "gateway", model: "active-vendor-model", config}));
        generator.onTurnCompleted("Review provider routing");
        config.model_providers.gateway.experimental_bridge = "rig";
        config.model_providers.gateway.http_headers["x-custom-auth"] = "changed-later";
        thread.resolve({thread: {id: "ephemeral"}});
        await generator.waitForIdle(1_000);
        expect(threadStart).toHaveBeenCalledWith(expect.objectContaining({
            modelProvider: "gateway",
            ephemeral: true,
            config: {model_providers: {gateway: {
                base_url: "https://gateway.example/v1",
                wire_api: "responses",
                experimental_bridge: "native",
                experimental_bearer_token: "private-token",
                query_params: {"api-version": "2026-10-22"},
                http_headers: {"x-custom-auth": "private-header"},
            }}},
        }));
        expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({model: "active-vendor-model"}));
    });

    it.each([null, "openai", "amazon-bedrock", "amazon-bedrock-runtime", "vendor"])(
        "captures the title model for provider %s before async thread creation",
        async provider => {
            const thread = deferred<{thread: {id: string}}>();
            const threadStart = vi.fn().mockReturnValue(thread.promise);
            const runTurn = vi.fn().mockResolvedValue({turn: {items: []}});
            let activeModel = "vendor-active-model";
            const generator = new TitleGenerator({
                threadStart,
                runTurn,
            } as unknown as CodexAppServerClient, "main", "/test/cwd", () => "unset",
            () => ({provider, model: activeModel}));
            generator.onTurnCompleted("Review provider routing");
            activeModel = "switched-while-thread-starting";
            thread.resolve({thread: {id: "ephemeral"}});
            await generator.waitForIdle(1_000);
            expect(threadStart).toHaveBeenCalledWith({cwd: "/test/cwd", ephemeral: true, modelProvider: provider});
            expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
                threadId: "ephemeral",
                model: provider === "vendor" ? "vendor-active-model" : "gpt-5.6-luna",
                outputSchema: expect.objectContaining({required: ["title"]}),
            }));
        },
    );
});

describe("TitleGenerator prompt", () => {
    it("sends only the start of a long first message to the title model", async () => {
        const runTurn = vi.fn().mockResolvedValue({turn: {items: []}});
        const generator = createGenerator({
            threadStart: vi.fn().mockResolvedValue({thread: {id: "ephemeral"}}),
            runTurn,
        } as unknown as Partial<CodexAppServerClient>);

        // The cut falls between the two halves of the emoji.
        generator.onTurnCompleted(`${"a".repeat(3_999)}\u{1F600}${"b".repeat(200_000)}`);
        await generator.waitForIdle(1_000);

        const text: string = runTurn.mock.calls[0]![0].input[0].text;
        expect(text.endsWith(`User's first message:\n${"a".repeat(3_999)}`)).toBe(true);
    });
});
