import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../../CodexAcpServer";
import type { ServerNotification } from "../../app-server";
import { createCodexMockTestFixture, createTestSessionState, setupPromptAndSendNotifications, type CodexMockTestFixture } from "../acp-test-utils";
import { AgentMode } from "../../AgentMode";

describe("CodexEventHandler - image events", () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = "test-session-id";

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    const sessionState: SessionState = createTestSessionState({
        sessionId,
        currentModelId: "model-id[effort]",
        agentMode: AgentMode.DEFAULT_AGENT_MODE,
    });

    it("maps image generation start and completion as an image tool call flow", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "imageGeneration",
                        id: "image-generation-1",
                        status: "generating",
                        revisedPrompt: null,
                        result: "",
                        failure: null,
                    },
                },
            },
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "imageGeneration",
                        id: "image-generation-1",
                        status: "generating",
                        revisedPrompt: "A tiny blue square",
                        result: "iVBORw0KGgo=",
                        failure: null,
                        savedPath: "/tmp/codex/generated-blue-square.png",
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/image-generation-flow.json"
        );
    });

    it("maps completed-only image generation as a full completed tool call", async () => {
        const completed: ServerNotification = {
            method: "item/completed",
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                completedAtMs: 0,
                item: {
                    type: "imageGeneration",
                    id: "image-generation-completed-only",
                    status: "generating",
                    revisedPrompt: null,
                    result: "iVBORw0KGgo=",
                    failure: null,
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [completed]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/image-generation-completed-only.json"
        );
    });

    it("maps view-image start and completion as one completed read tool call", async () => {
        const item = {
            type: "imageView" as const,
            id: "view-image-1",
            path: "/tmp/codex/input.png",
        };
        const notifications: ServerNotification[] = [
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item,
                },
            },
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item,
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/view-image-flow.json"
        );
    });

    it("maps image generation failure as a failed tool call surfacing the failure detail", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "imageGeneration",
                        id: "image-generation-failure",
                        status: "in_progress",
                        revisedPrompt: null,
                        result: "",
                        failure: null,
                    },
                },
            },
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "imageGeneration",
                        id: "image-generation-failure",
                        status: "failed",
                        revisedPrompt: "A tiny blue square",
                        result: "",
                        failure: {
                            type: "usageLimitExceeded",
                            limitId: "image_gen",
                            resetsAt: 1760000000,
                        },
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        const updates = mockFixture.getAcpConnectionEvents([])
            .filter((event) => event.method === "sessionUpdate")
            .map((event) => event.args[0]?.update)
            .filter((update) => update?.toolCallId === "image-generation-failure");
        expect(updates).toHaveLength(2);
        expect(updates[0]?.sessionUpdate).toBe("tool_call");
        expect(updates[0]?.status).toBe("in_progress");
        const failureUpdate = updates[1];
        expect(failureUpdate?.sessionUpdate).toBe("tool_call_update");
        expect(failureUpdate?.status).toBe("failed");
        // The failure must reach the tool call error surface, not just the status.
        expect(failureUpdate?.rawOutput).toMatchObject({
            failure: {
                type: "usageLimitExceeded",
                limitId: "image_gen",
                resetsAt: 1760000000,
            },
        });
        const failureText = JSON.stringify(failureUpdate?.content ?? []);
        expect(failureText).toContain("usage limit exceeded");
        expect(failureText).toContain("image_gen");
        expect(failureText).toContain("2025-10-09");

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/image-generation-failure.json"
        );
    });

    it("maps completed-only image generation failure without a start event", async () => {
        const completed: ServerNotification = {
            method: "item/completed",
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                completedAtMs: 0,
                item: {
                    type: "imageGeneration",
                    id: "image-generation-failure-completed-only",
                    status: "failed",
                    revisedPrompt: null,
                    result: "",
                    failure: {
                        type: "usageLimitExceeded",
                        limitId: "image_gen",
                        resetsAt: null,
                    },
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [completed]);

        const updates = mockFixture.getAcpConnectionEvents([])
            .filter((event) => event.method === "sessionUpdate")
            .map((event) => event.args[0]?.update)
            .filter((update) => update?.toolCallId === "image-generation-failure-completed-only");
        expect(updates).toHaveLength(1);
        const failureUpdate = updates[0];
        expect(failureUpdate?.sessionUpdate).toBe("tool_call");
        expect(failureUpdate?.status).toBe("failed");
        expect(failureUpdate?.rawOutput).toMatchObject({
            failure: {
                type: "usageLimitExceeded",
                limitId: "image_gen",
                resetsAt: null,
            },
        });
        const failureText = JSON.stringify(failureUpdate?.content ?? []);
        expect(failureText).toContain("usage limit exceeded");
        expect(failureText).toContain("image_gen");

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/image-generation-completed-only-failure.json"
        );
    });
});
