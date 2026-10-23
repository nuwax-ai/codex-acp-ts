import {describe, expect, it, vi} from "vitest";
import {CodexAppServerClient} from "../CodexAppServerClient";
import {TitleGenerator} from "../TitleGenerator";
import type {ServerNotification} from "../app-server";
import type {MessageConnection} from "vscode-jsonrpc/node";

function createUsageNotification(threadId: string, totalTokens = 100): ServerNotification {
    const usage = {
        totalTokens,
        inputTokens: 80,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 20,
        reasoningOutputTokens: 0,
    };
    return {
        method: "thread/tokenUsage/updated",
        params: {
            threadId,
            turnId: "turn-1",
            tokenUsage: {last: usage, total: usage, modelContextWindow: 128000},
        },
    };
}

function createMockConnection() {
    let notify: ((notification: ServerNotification | Record<string, unknown>) => void) | null = null;
    let nextHiddenThread = 0;
    const connection = {
        onUnhandledNotification: (callback: (notification: ServerNotification | Record<string, unknown>) => void) => {
            notify = callback;
        },
        onRequest: () => {},
        onNotification: () => {},
        end: () => {},
        sendRequest: async (method: string, params: {threadId?: string}) => {
            if (method === "thread/start") {
                return {thread: {id: `hidden-title-${++nextHiddenThread}`}};
            }
            if (method === "turn/start" && params.threadId !== undefined) {
                // A title turn emits its usage snapshot and completes before the
                // turn/start response resolves, like a real mock vendor turn.
                notify?.(createUsageNotification(params.threadId));
                const turn = {id: "title-turn", items: [], status: "completed", error: null};
                notify?.({method: "turn/completed", params: {threadId: params.threadId, turn}});
                return {turn};
            }
            return {};
        },
    } as unknown as MessageConnection;
    return {
        connection,
        send: (notification: ServerNotification | Record<string, unknown>) => {
            notify?.(notification);
        },
    };
}

function armedCaptures(client: CodexAppServerClient): Map<string, unknown> {
    return (client as unknown as {pendingRestoredTokenUsage: Map<string, unknown>}).pendingRestoredTokenUsage;
}

describe("CodexAppServerClient restored token usage capture", () => {
    it("never accumulates entries for handler-less ephemeral title threads", async () => {
        const {connection} = createMockConnection();
        const client = new CodexAppServerClient(connection);

        for (let index = 0; index < 100; index++) {
            const mainId = `session-${index}`;
            const generator = new TitleGenerator(
                client,
                mainId,
                "/test/project",
                () => "unset",
                () => ({provider: "custom", model: "mock"}),
            );
            generator.onTurnCompleted("a user prompt");
            await generator.waitForIdle(1000);
            client.clearThreadHandlers(mainId);
        }

        expect(armedCaptures(client).size).toBe(0);
    });

    it("does not buffer usage notifications for threads that were never armed", () => {
        const {connection, send} = createMockConnection();
        const client = new CodexAppServerClient(connection);

        send(createUsageNotification("never-armed-thread"));

        expect(armedCaptures(client).size).toBe(0);
    });

    it("captures the replay only while armed and consumes it exactly once", () => {
        const {connection, send} = createMockConnection();
        const client = new CodexAppServerClient(connection);
        const handler = vi.fn();
        client.onServerNotification("thread-1", handler);

        client.armRestoredTokenUsageCapture("thread-1");
        send(createUsageNotification("thread-1"));
        // Suppressed while armed: a pre-load handler must not see the replay.
        expect(handler).not.toHaveBeenCalled();

        const captured = client.takePendingRestoredTokenUsage("thread-1");
        expect(captured).not.toBeNull();
        expect(captured?.tokenUsage.total.totalTokens).toBe(100);
        expect(armedCaptures(client).size).toBe(0);

        // A replay of the snapshot that was just applied is a duplicate: delivering it would roll
        // the reloaded state back to the totals the load already replaced.
        send(createUsageNotification("thread-1"));
        expect(handler).not.toHaveBeenCalled();

        // A newer snapshot is live usage and flows to the handler again.
        send(createUsageNotification("thread-1", 250));
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]?.[0]?.method).toBe("thread/tokenUsage/updated");

        // A second take finds nothing: no double-application surface.
        expect(client.takePendingRestoredTokenUsage("thread-1")).toBeNull();
    });

    it("keeps subscription events flowing for other threads while a capture is armed", () => {
        const {connection, send} = createMockConnection();
        const client = new CodexAppServerClient(connection);
        const handler = vi.fn();
        client.onServerNotification("thread-live", handler);

        client.armRestoredTokenUsageCapture("thread-loading");
        send({
            method: "thread/status/changed",
            params: {threadId: "thread-live", status: {type: "idle"}},
        } as ServerNotification);
        send(createUsageNotification("thread-live"));

        expect(handler).toHaveBeenCalledTimes(2);
        expect(armedCaptures(client).has("thread-loading")).toBe(true);
    });

    it("flushes a captured snapshot into a late subscriber and ends the late window", () => {
        const {connection, send} = createMockConnection();
        const client = new CodexAppServerClient(connection);

        client.armRestoredTokenUsageCapture("resumed-thread");
        send(createUsageNotification("resumed-thread"));

        // The live subscription supersedes the capture: it takes the snapshot the load never
        // consumed, and the late window ends there.
        const lateSubscriber = vi.fn();
        client.releaseRestoredTokenUsageCapture("resumed-thread", lateSubscriber);
        expect(lateSubscriber).toHaveBeenCalledTimes(1);
        expect(lateSubscriber.mock.calls[0]?.[0]?.method).toBe("thread/tokenUsage/updated");
        expect(armedCaptures(client).size).toBe(0);

        // An armed capture without a snapshot just disarms on subscription.
        client.armRestoredTokenUsageCapture("silent-thread");
        const quietSubscriber = vi.fn();
        client.releaseRestoredTokenUsageCapture("silent-thread", quietSubscriber);
        expect(quietSubscriber).not.toHaveBeenCalled();
        expect(armedCaptures(client).size).toBe(0);
    });

    it("clears an armed capture when the thread handlers are cleared", () => {
        const {connection} = createMockConnection();
        const client = new CodexAppServerClient(connection);

        client.armRestoredTokenUsageCapture("closing-thread");
        client.clearThreadHandlers("closing-thread");

        expect(armedCaptures(client).size).toBe(0);
        expect(client.takePendingRestoredTokenUsage("closing-thread")).toBeNull();
    });

    it("bounds settled captures at the cap without evicting an in-flight load", () => {
        const {connection, send} = createMockConnection();
        const client = new CodexAppServerClient(connection);

        client.armRestoredTokenUsageCapture("in-flight-load");
        for (let index = 0; index < 80; index++) {
            const owner = client.armRestoredTokenUsageCapture(`settled-${index}`);
            client.settleRestoredTokenUsageCapture(`settled-${index}`, owner);
        }

        const captures = armedCaptures(client);
        expect(captures.size).toBeLessThanOrEqual(64);
        // The in-flight load survives the pressure; oldest settled go first.
        expect(captures.has("in-flight-load")).toBe(true);
        expect(captures.has("settled-0")).toBe(false);
        expect(captures.has("settled-79")).toBe(true);

        // The surviving in-flight capture still receives and yields its replay.
        send(createUsageNotification("in-flight-load"));
        const captured = client.takePendingRestoredTokenUsage("in-flight-load");
        expect(captured?.tokenUsage.total.totalTokens).toBe(100);
    });

    it("returns to the retention target as previously pinned requests settle", () => {
        const {connection} = createMockConnection();
        const client = new CodexAppServerClient(connection);
        const owners = Array.from({length: 80}, (_, index) => client.armRestoredTokenUsageCapture(`in-flight-${index}`));
        // In-flight requests are never discarded to meet a settled retention target.
        expect(armedCaptures(client).size).toBe(80);
        owners.forEach((owner, index) => client.settleRestoredTokenUsageCapture(`in-flight-${index}`, owner));
        expect(armedCaptures(client).size).toBeLessThanOrEqual(64);
    });

    it("does not let a completed or failed older resume alter a reopened capture", () => {
        const {connection, send} = createMockConnection();
        const client = new CodexAppServerClient(connection);
        const previous = client.armRestoredTokenUsageCapture("reopened-thread");
        client.clearThreadHandlers("reopened-thread");
        const current = client.armRestoredTokenUsageCapture("reopened-thread");
        client.settleRestoredTokenUsageCapture("reopened-thread", previous);
        client.clearRestoredTokenUsageCapture("reopened-thread", previous);
        expect(armedCaptures(client).get("reopened-thread")).toMatchObject({owner: current, inFlight: true});
        send(createUsageNotification("reopened-thread"));
        expect(client.takePendingRestoredTokenUsage("reopened-thread")?.tokenUsage.total.totalTokens).toBe(100);
    });

    it("releases every capture on dispose", () => {
        const {connection} = createMockConnection();
        const client = new CodexAppServerClient(connection);

        client.armRestoredTokenUsageCapture("thread-a");
        client.armRestoredTokenUsageCapture("thread-b");
        client.dispose();

        expect(armedCaptures(client).size).toBe(0);
    });
});
