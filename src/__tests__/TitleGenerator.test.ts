import {describe, expect, it, vi} from "vitest";
import {TitleGenerator} from "../TitleGenerator";
import type {CodexAppServerClient} from "../CodexAppServerClient";

function deferred<T>(): {promise: Promise<T>; resolve: (value: T) => void} {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>(innerResolve => {
        resolve = innerResolve;
    });
    return {promise, resolve};
}

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
