import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import type {Thread, ThreadResumeResponse, ThreadTokenUsage} from "../../app-server/v2";
import {toTokenCount} from "../../TokenCount";

const request = {sessionId: "warm-thread", cwd: "/test/project", mcpServers: []};
const previousUsage: ThreadTokenUsage = {
    last: {totalTokens: 2500, inputTokens: 2000, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 450, reasoningOutputTokens: 50},
    total: {totalTokens: 9000, inputTokens: 7000, cachedInputTokens: 1000, cacheWriteInputTokens: 0, outputTokens: 1800, reasoningOutputTokens: 200},
    modelContextWindow: 128000,
};

async function warmFixture() {
    const fixture = createCodexMockTestFixture();
    const agent = fixture.getCodexAcpAgent();
    const client = fixture.getCodexAcpClient();
    const appServer = fixture.getCodexAppServerClient();
    vi.spyOn(client, "authRequired").mockResolvedValue(false);
    vi.spyOn(client, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
    const model = createTestModel();
    vi.spyOn(appServer, "listModels").mockResolvedValue({data: [model], nextCursor: null});
    const thread: Thread = {
        id: request.sessionId, sessionId: request.sessionId, forkedFromId: null, parentThreadId: null,
        preview: "Prior turn", ephemeral: false, section: null, sectionEnteredAt: null, projectId: null,
        historyMode: "legacy", modelProvider: "vendor", model: model.id, reasoningEffort: "medium",
        createdAt: 1, updatedAt: 2, recencyAt: null, status: {type: "idle"}, path: null, cwd: request.cwd,
        cliVersion: "test", originator: null, source: "cli", threadSource: null, agentNickname: null,
        agentRole: null, gitInfo: null, name: null, turns: [],
    };
    const state: {replay: ThreadTokenUsage | null; response: ThreadResumeResponse} = {
        replay: previousUsage,
        response: {
            thread, model: model.id, modelProvider: "vendor", serviceTier: null, disabledPluginIds: [],
            cwd: request.cwd, instructionSources: [], approvalPolicy: "never", approvalsReviewer: "user",
            sandbox: {type: "dangerFullAccess"}, reasoningEffort: "medium", collaborationMode: null,
            turnsBackwardsCursor: null, itemsBackwardsCursor: null,
        },
    };
    vi.spyOn(appServer, "threadResume").mockImplementation(async () => {
        if (state.replay !== null) {
            const tokenUsage = state.replay;
            queueMicrotask(() => fixture.sendServerNotification({
                method: "thread/tokenUsage/updated", params: {threadId: request.sessionId, turnId: "prior-turn", tokenUsage},
            }));
        }
        return state.response;
    });
    vi.spyOn(appServer, "threadReadWithHistory").mockImplementation(async () => ({thread: state.response.thread}));
    await agent.initialize({protocolVersion: 1});
    await agent.loadSession(request);
    state.replay = null;
    fixture.clearAcpConnectionDump();
    return {fixture, agent, client, appServer, state};
}

function usageUpdates(fixture: Awaited<ReturnType<typeof warmFixture>>["fixture"]) {
    return fixture.getAcpConnectionEvents([])
        .filter(event => event.method === "sessionUpdate")
        .map(event => event.args[0]?.update)
        .filter(update => update?.sessionUpdate === "usage_update");
}

function usageState(agent: Awaited<ReturnType<typeof warmFixture>>["agent"], sessionId = request.sessionId) {
    const {lastTokenUsage, totalTokenUsage, modelContextWindow} = agent.getSessionState(sessionId);
    return {lastTokenUsage, totalTokenUsage, modelContextWindow};
}

async function promptWithUsage(context: Awaited<ReturnType<typeof warmFixture>>, tokenUsage: ThreadTokenUsage | null) {
    const {fixture, appServer, agent} = context;
    const turn = {
        id: "next-turn", items: [], itemsView: "notLoaded" as const, status: "completed" as const,
        error: null, startedAt: null, completedAt: null, durationMs: null,
    };
    vi.spyOn(appServer, "turnStart").mockResolvedValue({turn: {...turn, status: "inProgress"}});
    vi.spyOn(appServer, "awaitTurnCompleted").mockImplementation(async () => {
        if (tokenUsage !== null) fixture.sendServerNotification({
            method: "thread/tokenUsage/updated", params: {threadId: request.sessionId, turnId: turn.id, tokenUsage},
        });
        return {threadId: request.sessionId, turn};
    });
    return await agent.prompt({sessionId: request.sessionId, prompt: [{type: "text", text: "Continue."}]});
}

const expectedPrevious = {lastTokenUsage: toTokenCount(previousUsage.last), totalTokenUsage: toTokenCount(previousUsage.total), modelContextWindow: 128000};

describe("warm restored usage", () => {
    it.each(["loadSession", "resumeSession"] as const)("%s retains the existing ledger without a server replay", async operation => {
        const {agent, fixture} = await warmFixture();
        await agent[operation](request);
        expect(usageState(agent)).toEqual(expectedPrevious);
        expect(usageUpdates(fixture)).toEqual([{sessionUpdate: "usage_update", used: 2500, size: 128000}]);
    });
    it.each(["loadSession", "resumeSession"] as const)("%s gives an explicit zero server snapshot priority over the prior ledger", async operation => {
        const context = await warmFixture();
        const zero = {totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0};
        context.state.replay = {last: zero, total: zero, modelContextWindow: 64000};
        await context.agent[operation](request);
        expect(usageState(context.agent)).toEqual({lastTokenUsage: toTokenCount(zero), totalTokenUsage: toTokenCount(zero), modelContextWindow: 64000});
        expect(usageUpdates(context.fixture)).toEqual([{sessionUpdate: "usage_update", used: 0, size: 64000}]);
    });

    it.each(["loadSession", "resumeSession"] as const)("%s preserves an authoritative unknown window instead of borrowing the old one", async operation => {
        const context = await warmFixture();
        context.state.replay = {...previousUsage, modelContextWindow: null};
        await context.agent[operation](request);
        expect(usageState(context.agent)).toEqual({...expectedPrevious, modelContextWindow: null});
        expect(usageUpdates(context.fixture)).toEqual([]);
    });

    it.each(["loadSession", "resumeSession"] as const)("%s retains cumulative totals without inventing missing last-turn usage", async operation => {
        const context = await warmFixture();
        await promptWithUsage(context, null);
        context.fixture.clearAcpConnectionDump();
        expect(usageState(context.agent)).toEqual({...expectedPrevious, lastTokenUsage: null});
        await context.agent[operation](request);
        expect(usageState(context.agent)).toEqual({...expectedPrevious, lastTokenUsage: null});
        expect(usageUpdates(context.fixture)).toEqual([]);
    });

    it.each(["loadSession", "resumeSession"] as const)("%s never borrows the ledger of a closed session", async operation => {
        const context = await warmFixture();
        await context.agent.closeSession({sessionId: request.sessionId});
        context.fixture.clearAcpConnectionDump();
        await context.agent[operation](request);
        expect(usageState(context.agent)).toEqual({lastTokenUsage: null, totalTokenUsage: null, modelContextWindow: null});
        expect(usageUpdates(context.fixture)).toEqual([]);
    });

    it.each(["loadSession", "resumeSession"] as const)("%s leaves the current ledger intact if the resume request fails", async operation => {
        const context = await warmFixture();
        const before = context.agent.getSessionState(request.sessionId);
        vi.mocked(context.appServer.threadResume).mockRejectedValueOnce(new Error("resume refused"));
        await expect(context.agent[operation](request)).rejects.toThrow("resume refused");
        expect(context.agent.getSessionState(request.sessionId)).toBe(before);
        expect(usageState(context.agent)).toEqual(expectedPrevious);
        expect(usageUpdates(context.fixture)).toEqual([]);
    });

    it.each(["loadSession", "resumeSession"] as const)("%s keeps history usage across a model/provider switch and accepts the next window", async operation => {
        const context = await warmFixture();
        const nextModel = createTestModel({id: "other-model"});
        vi.mocked(context.appServer.listModels).mockResolvedValue({data: [nextModel], nextCursor: null});
        context.state.response = {...context.state.response, model: nextModel.id, modelProvider: "other-vendor"};
        await context.agent[operation](request);
        expect(context.agent.getSessionState(request.sessionId).currentModelId).toBe("other-model[medium]");
        expect(context.agent.getSessionState(request.sessionId).authProvider).toBe("other-vendor");
        expect(usageState(context.agent)).toEqual(expectedPrevious);

        const nextUsage: ThreadTokenUsage = {
            last: {...previousUsage.last, totalTokens: 42, inputTokens: 30, cachedInputTokens: 0, outputTokens: 12, reasoningOutputTokens: 0},
            total: {...previousUsage.total, totalTokens: 9042}, modelContextWindow: 32000,
        };
        await promptWithUsage(context, nextUsage);
        expect(usageState(context.agent)).toEqual({lastTokenUsage: toTokenCount(nextUsage.last), totalTokenUsage: toTokenCount(nextUsage.total), modelContextWindow: 32000});
    });

    it("does not attribute a source thread's usage to a new fork", async () => {
        const context = await warmFixture();
        vi.spyOn(context.client, "forkSession").mockResolvedValue({
            sessionId: "fork-thread", currentModelId: "model-id[medium]", models: [createTestModel()],
            collaborationMode: "default", modelProvider: "vendor", currentServiceTier: null, additionalDirectories: [],
        });
        await context.agent.forkSession(request);
        expect(usageState(context.agent, "fork-thread")).toEqual({lastTokenUsage: null, totalTokenUsage: null, modelContextWindow: null});
        expect(usageState(context.agent)).toEqual(expectedPrevious);
        expect(usageUpdates(context.fixture)).toEqual([]);
    });

});
