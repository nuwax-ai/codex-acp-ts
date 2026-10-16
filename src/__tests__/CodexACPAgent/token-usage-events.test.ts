import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerNotification } from '../../app-server';
import { createCodexMockTestFixture, createTestSessionState, createTestModel, type CodexMockTestFixture } from '../acp-test-utils';
import type { Thread, TokenUsageBreakdown } from '../../app-server/v2';
import { toTokenCount } from '../../TokenCount';

function createTokenUsageNotification(
    sessionId: string,
    tokenUsage: {
        total: TokenUsageBreakdown;
        last: TokenUsageBreakdown;
        modelContextWindow: number | null;
    }
): ServerNotification {
    return {
        method: 'thread/tokenUsage/updated',
        params: {
            threadId: sessionId,
            turnId: 'turn-id',
            tokenUsage,
        },
    };
}

describe('Token Usage Events', () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });
    describe('PromptResponse usage', () => {
        function setupPromptWithTokenUsage(notifications: ServerNotification[], turnStatus: string = "completed") {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });

            // awaitTurnCompleted sends notifications before resolving
            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                // Send notifications during turn (after handler is registered)
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId }));

            return codexAcpAgent;
        }

        it('should include token_count in PromptResponse on end_turn', async () => {
            const tokenUsageNotification = createTokenUsageNotification(sessionId, {
                total: {
                    totalTokens: 5000,
                    inputTokens: 4000,
                    cachedInputTokens: 1000,
                    cacheWriteInputTokens: 0,
                    outputTokens: 900,
                    reasoningOutputTokens: 100,
                },
                last: {
                    totalTokens: 2500,
                    inputTokens: 2000,
                    cachedInputTokens: 500,
                    cacheWriteInputTokens: 0,
                    outputTokens: 450,
                    reasoningOutputTokens: 50,
                },
                modelContextWindow: 128000,
            });

            const codexAcpAgent = setupPromptWithTokenUsage([tokenUsageNotification]);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-end-turn.json'
            );
        });

        it('should include token_count in PromptResponse on cancelled', async () => {
            const tokenUsageNotification = createTokenUsageNotification(sessionId, {
                total: {
                    totalTokens: 3000,
                    inputTokens: 2500,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 500,
                    reasoningOutputTokens: 0,
                },
                last: {
                    totalTokens: 1500,
                    inputTokens: 1200,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 300,
                    reasoningOutputTokens: 0,
                },
                modelContextWindow: 128000,
            });

            const codexAcpAgent = setupPromptWithTokenUsage([tokenUsageNotification], "interrupted");

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-cancelled.json'
            );
        });

        it('should return null token_count when no token usage event received', async () => {
            const codexAcpAgent = setupPromptWithTokenUsage([]);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-null.json'
            );
        });

        it('should use last token usage from multiple updates', async () => {
            const notifications: ServerNotification[] = [
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 2000, inputTokens: 1600, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 3500, inputTokens: 2800, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 100 },
                    last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 100 },
                    modelContextWindow: 128000,
                }),
            ];

            const codexAcpAgent = setupPromptWithTokenUsage(notifications);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-multiple-updates.json'
            );
        });
    });

    describe('session/update usage_update', () => {
        function setupPromptAndReturnEvents(notifications: ServerNotification[], turnStatus: string = "completed") {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });

            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId }));

            return async () => {
                await codexAcpAgent.prompt({
                    sessionId,
                    prompt: [{ type: 'text', text: 'test prompt' }],
                });
                return mockFixture.getAcpConnectionEvents([]);
            };
        }

        it('should emit usage_update with latest turn usage as a context proxy', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: {
                        totalTokens: 5000,
                        inputTokens: 4000,
                        cachedInputTokens: 1000,
                        cacheWriteInputTokens: 0,
                        outputTokens: 900,
                        reasoningOutputTokens: 100,
                    },
                    last: {
                        totalTokens: 2500,
                        inputTokens: 2000,
                        cachedInputTokens: 500,
                        cacheWriteInputTokens: 0,
                        outputTokens: 450,
                        reasoningOutputTokens: 50,
                    },
                    modelContextWindow: 128000,
                }),
            ])();

            await expect(`${JSON.stringify(events[0], null, 2)}\n`).toMatchFileSnapshot('data/token-usage-session-update.json');
        });

        it('should emit latest turn usage from multiple updates', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 2000, inputTokens: 1600, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 3500, inputTokens: 2800, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 100 },
                    last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 100 },
                    modelContextWindow: 128000,
                }),
            ])();

            await expect(`${JSON.stringify(events, null, 2)}\n`).toMatchFileSnapshot('data/token-usage-session-update-multiple.json');
        });

        it('should skip usage_update when model context window is unavailable', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 5000, inputTokens: 4000, cachedInputTokens: 1000, cacheWriteInputTokens: 0, outputTokens: 900, reasoningOutputTokens: 100 },
                    last: { totalTokens: 2500, inputTokens: 2000, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 450, reasoningOutputTokens: 50 },
                    modelContextWindow: null,
                }),
            ])();

            expect(events).toEqual([]);
        });
    });

    describe('restored usage after loadSession', () => {
        const restoredTotal: TokenUsageBreakdown = {
            totalTokens: 5000,
            inputTokens: 4000,
            cachedInputTokens: 1000,
            cacheWriteInputTokens: 0,
            outputTokens: 900,
            reasoningOutputTokens: 100,
        };
        const restoredLast: TokenUsageBreakdown = {
            totalTokens: 2500,
            inputTokens: 2000,
            cachedInputTokens: 500,
            cacheWriteInputTokens: 0,
            outputTokens: 450,
            reasoningOutputTokens: 50,
        };

        function setupLoadSessionWithRestoredUsage(
            fixture: CodexMockTestFixture,
            modelContextWindow: number | null,
        ) {
            const agent = fixture.getCodexAcpAgent();
            const client = fixture.getCodexAcpClient();
            const appServer = fixture.getCodexAppServerClient();

            client.authRequired = vi.fn().mockResolvedValue(false);
            client.getAccount = vi.fn().mockResolvedValue({
                account: null,
                requiresOpenaiAuth: false,
            });
            client.listSkills = vi.fn().mockResolvedValue({ data: [] });

            const model = createTestModel();
            appServer.listModels = vi.fn().mockResolvedValue({
                data: [model],
                nextCursor: null,
            });

            const thread: Thread = {
                id: 'session-1',
                sessionId: 'session-1',
                parentThreadId: null,
                threadSource: null,
                originator: null,
                forkedFromId: null,
                preview: 'Hi',
                ephemeral: false,
                modelProvider: 'openai',
                model: null,
                reasoningEffort: null,
                createdAt: 123,
                updatedAt: 124,
                recencyAt: null,
                status: { type: 'idle' },
                path: null,
                cwd: '/test/project',
                cliVersion: '0.0.0',
                section: null,
                sectionEnteredAt: null,
                projectId: null,
                historyMode: 'legacy',
                source: 'cli',
                agentNickname: null,
                agentRole: null,
                gitInfo: null,
                name: null,
                turns: [],
            };
            appServer.threadResume = vi.fn().mockImplementation(async () => {
                // The app-server replays the persisted `thread/tokenUsage/updated`
                // snapshot to the attaching connection right after the resume
                // response, mirroring the wire's response-then-notification order.
                queueMicrotask(() => {
                    fixture.sendServerNotification(createTokenUsageNotification('session-1', {
                        total: restoredTotal,
                        last: restoredLast,
                        modelContextWindow,
                    }));
                });
                return {
                    thread,
                    model: model.id,
                    modelProvider: 'openai',
                    cwd: '/test/project',
                    approvalPolicy: 'never',
                    sandbox: { type: 'dangerFullAccess' },
                    reasoningEffort: model.defaultReasoningEffort,
                };
            });
            appServer.threadReadWithHistory = vi.fn().mockResolvedValue({ thread });

            return agent;
        }

        it('should surface the restored usage replay as usage_update with total/last preserved', async () => {
            const fixture = createCodexMockTestFixture();
            const agent = setupLoadSessionWithRestoredUsage(fixture, 128000);

            await agent.initialize({ protocolVersion: 1 });

            await agent.loadSession({
                sessionId: 'session-1',
                cwd: '/test/project',
                mcpServers: [],
            });

            // The restored cumulative usage must land in the session state.
            const state = agent.getSessionState('session-1');
            expect(state.totalTokenUsage).toEqual(toTokenCount(restoredTotal));
            expect(state.lastTokenUsage).toEqual(toTokenCount(restoredLast));
            expect(state.modelContextWindow).toBe(128000);

            // And the client must receive the restored usage_update.
            const usageUpdates = fixture.getAcpConnectionEvents([])
                .filter((event) => event.method === 'sessionUpdate')
                .map((event) => event.args[0]?.update)
                .filter((update) => update?.sessionUpdate === 'usage_update');
            expect(usageUpdates).toEqual([
                { sessionUpdate: 'usage_update', used: 2500, size: 128000 },
            ]);
        });

        it('should keep restored usage state even when usage_update cannot be derived', async () => {
            const fixture = createCodexMockTestFixture();
            const agent = setupLoadSessionWithRestoredUsage(fixture, null);

            await agent.initialize({ protocolVersion: 1 });

            await agent.loadSession({
                sessionId: 'session-1',
                cwd: '/test/project',
                mcpServers: [],
            });

            const state = agent.getSessionState('session-1');
            expect(state.totalTokenUsage).toEqual(toTokenCount(restoredTotal));
            expect(state.lastTokenUsage).toEqual(toTokenCount(restoredLast));
            expect(state.modelContextWindow).toBeNull();

            const usageUpdates = fixture.getAcpConnectionEvents([])
                .filter((event) => event.method === 'sessionUpdate')
                .map((event) => event.args[0]?.update)
                .filter((update) => update?.sessionUpdate === 'usage_update');
            expect(usageUpdates).toEqual([]);
        });
    });
});
